---
id: features-format
status: fixed
version: 1.0
---

# FEATURE CATALOG FORMAT — fixed file. Never edit without explicit user request.

This is the **authoring contract** for `docs/features/App-Features.md`.

A feature catalog for a serious product is 1500–4000 lines. No agent can read
that on every task, and one that tries will keep half of it and invent the rest.
This format exists so the catalog can be **indexed and addressed by id** instead
of being read. Follow it exactly and the tooling works; deviate and the ingest
falls back to guessing.

Hand this file to whoever (human or model) writes the catalog. The
copy-paste prompt is in §10.

---

## 0. THE CONTRACT IN FOUR LINES

1. Every feature has a **permanent id** and lives in exactly **one table row**.
2. Every heading is machine-parseable, so every id resolves to a **line range**.
3. Nothing outside the catalog ever stores a line number — only ids.
4. `python3 tools/features-scan.py --check` must exit 0.

---

## 1. FILE LOCATION

```
docs/features/App-Features.md     the catalog. THE ONLY hand-written file here.
docs/features/MANIFEST.md         GENERATED. never hand-edit.
docs/features/DROPPED.md          catalog ids deliberately not built + why.
```

One catalog file. If it passes ~4000 lines, split by area into
`App-Features-<area>.md` — the tooling globs `docs/features/App-Features*.md`.

**Never** open the catalog directly during normal work. Use `tools/spec.py`.

---

## 2. DOCUMENT SKELETON

```markdown
---
id: app-features
status: active
version: 3
updated: YYYY-MM-DD
---

# <Product> — Feature Catalog

> One-paragraph statement of what the product is.
> Assumption of this document: <e.g. "describes the target state, not today's code">.

## Status vocabulary
<the table from §4 verbatim>

## Decisions
<D-nn rows — see §5>

## Constraints
<C-nn rows — see §5>

## Invariants
<INV-nn rows — see §5>

## Section 01 — <Area name>
### 1.1 <Sub-area>
<prose explaining how it works>

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0101 | ... | new | — | ... |
```

Order is fixed: front matter → intro → status vocabulary → D → C → INV →
sections. Decisions before features, always: a reader must hit the rules before
the list.

---

## 3. HEADINGS — exact shape, no exceptions

| Level | Shape | Meaning |
|---|---|---|
| `#` | `# <Product> — Feature Catalog` | exactly one, first line after front matter |
| `##` | `## Section <NN> — <Area name>` | one per area. `NN` is zero-padded, 01–99. |
| `###` | `### <NN>.<M> <Sub-area name>` | optional. This is the **addressable unit** — `spec.py` prints this block. |
| `####` | anything | free. Not indexed. |

Rules:
- `Section 07` and its features `F-07xx` **must** share the number. This is what
  makes `spec.py --area 07` work without a lookup table.
- Never renumber a section. A dead area keeps its number and its heading gets
  ` (retired)` appended.
- Keep a `###` block under ~120 lines. It is the quantum an agent reads.

---

## 4. STATUS VOCABULARY — exactly these five, lowercase

| status | meaning |
|---|---|
| `core` | specified in an earlier version of this catalog, unchanged |
| `new` | added in this version |
| `changed` | a previous decision was reversed. **Must** cite the `C-nn` in `note`. |
| `partial` | the infrastructure exists but there is no surface for it yet |
| `later` | designed, schema reserved, deliberately not built now |

`later` features still get a backlog row (as `todo`, noted `later`). They are not
invisible; they are scheduled.

---

## 5. ID SCHEME — permanent, never reused, never renumbered

| Prefix | Shape | For |
|---|---|---|
| `F-` | `F-<NN><MM>` — 4 digits | a feature. `NN` = section number, `MM` = 01..99 within it. |
| `D-` | `D-<NN>` | a **decision** that overrides everything else in the catalog |
| `C-` | `C-<NN>` | a **constraint**: a conflict that was resolved, and how |
| `INV-` | `INV-<NN>` | an **invariant**: something that must never happen |

Hard rules:
- An id is written **once** as the row that defines it, and referenced
  everywhere else. `python3 tools/features-scan.py --check` fails on duplicates.
- Deleting a feature is forbidden. Set its row to `later`, or move the id to
  `DROPPED.md` with a reason. **A missing id is indistinguishable from an
  accident.**
- Cross-reference by id only. Never "see the section above", never a page or
  line number.
- Renumbering breaks every backlog row, every commit message, and every ADR that
  cites it. There is no situation that justifies it.

### D / C / INV rows

```markdown
## Decisions
| id | decision | why |
|---|---|---|
| D-01 | Traffic is always prepaid. There is never a payout. | removes KYC/AML exposure and the largest fraud vector |

## Constraints
| id | conflict | resolution |
|---|---|---|
| C-07 | Cache keyed on `(grantId, panelSetHash)`, but F-0705 puts rotating domains in the body — a stale cache serves a dead domain. | key becomes `(grantId, panelSetHash, domainSetHash, format)`, invalidated explicitly on any domain state change |

## Invariants
| id | invariant | blast radius if broken |
|---|---|---|
| INV-03 | `SUM(ledger_entry.amount) = 0` per transaction, enforced by a DB trigger | silent money loss, unrecoverable |
```

`INV-` rows are the most valuable content in the catalog. They migrate verbatim
into each unit's `invariants.md`, which outranks every contract (§0 of
`00-PROTOCOL.md`). Extract them explicitly — do not leave them buried in prose.

---

## 6. THE FEATURE TABLE — exact columns, exact order

```markdown
| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0705 | Subscription link auto-rotates domains: response carries the standby list and a short `Profile-Update-Interval` | new | F-0701 F-1302 | C-07; the app caches the link, so a filtered domain orphans the user |
```

| column | rule |
|---|---|
| `id` | §5. Unique across the whole catalog. |
| `feature` | **One shippable thing, phrased as a capability.** Not an epic, not a component name. See §7. |
| `status` | §4, lowercase, nothing else. |
| `depends_on` | space-separated `F-` ids, or `—`. Only real ordering constraints. |
| `note` | why it exists, the `C-`/`D-`/`INV-` ids it touches, and the sharp edge. Free text. |

Every feature is a **row**. A capability described only in prose does not exist —
the scanner cannot see it, so the ingest will never create a backlog row for it,
so it will never be built. Prose explains *how*; the table declares *what*.

---

## 7. SIZING — the rule that decides whether this works

> **One feature = one thing a competent engineer finishes, reviews, and merges
> in one sitting.**

If a row needs "and" between two different capabilities, it is two rows.

| Too big (an epic) | Correct |
|---|---|
| `Payment system` | `F-0501 Wallet debit is one atomic transaction: lock, check, ledger rows, balance, invoice -> paid` |
| | `F-0502 Gateway callbacks are idempotent on (gatewayKey, providerTxId), unique-constrained` |
| | `F-0503 Amount mismatch between quote and callback -> human review queue, never auto-credit` |

Oversized rows are the #1 failure mode. They produce backlog items nobody can
start, and they silently become "in progress" for months. `--check` warns when a
`###` block carries more than 15 feature rows — usually a sign the area needs
splitting, not that the rows are wrong.

---

## 8. ENTITY DECLARATIONS

When an area owns state, declare it in a fenced block. The scanner indexes these
so the unit map can be anchored on table ownership.

````markdown
```
LedgerAccount(tree, kind, ownerRef)
    tree: tenant_billing | platform_billing
    kind: user_wallet | gateway_clearing | platform_revenue

LedgerTransaction(kind, reference, description, actorUserId)
```
````

- One entity per line, `PascalCase(` at the start of the line.
- Field constraints indented underneath.
- This is a **sketch for boundary-finding**, not a schema. The real schema lives
  in Prisma/SQL and outranks this file (`00-PROTOCOL.md` §0). Never let the two
  drift into competing definitions — if they disagree, the schema is right.

---

## 9. FORBIDDEN

| Never | Because |
|---|---|
| a feature without an id | invisible to the ingest; will never be built |
| a feature described only in prose | same |
| reusing or renumbering an id | breaks every backlog row and commit that cites it |
| deleting a row | a missing id looks like an accident, not a decision |
| "see above" / page numbers / line numbers | the only stable address is the id |
| an epic as one row | produces an unstartable backlog item |
| duplicating a field list that exists in the schema | guaranteed drift |
| a status outside §4 | `--check` fails |
| two ids for the same capability | the ingest creates two rows, someone builds it twice |

---

## 10. PROMPT FOR THE AUTHORING MODEL

> You are writing a feature catalog that will be consumed by tooling, not read
> by a human end to end. Follow `docs/FEATURES-FORMAT.md` **exactly** — it is a
> machine contract, not a style guide.
>
> Non-negotiable:
> - Headings are exactly `## Section <NN> — <Area>` and `### <NN>.<M> <Sub-area>`.
> - Every capability is one row in a `| id | feature | status | depends_on | note |`
>   table. If it is not a row, it does not exist.
> - Ids are `F-<NN><MM>` where `NN` matches the section number. Permanent.
> - `status` is one of: core, new, changed, partial, later.
> - One row = one thing shippable in a single sitting. Split anything with an
>   "and" in it.
> - Put decisions (`D-nn`), resolved conflicts (`C-nn`) and invariants (`INV-nn`)
>   in their own tables **before** the sections, and reference them by id from
>   the `note` column.
> - Prose explains how a thing works; the table declares what gets built. Both
>   are required.
> - Declare owned state in fenced `PascalCase(field, field)` blocks.
>
> Here are the features to write up: <paste>
>
> Output the complete `docs/features/App-Features.md` and nothing else.

---

## 11. VALIDATE BEFORE YOU TRUST IT

```bash
python3 tools/features-scan.py            # rebuild docs/features/MANIFEST.md
python3 tools/features-scan.py --check    # format + coverage. must exit 0.
python3 tools/spec.py F-0705              # what one feature costs to read
python3 tools/spec.py --area 07           # everything in one area
python3 tools/spec.py --todo              # catalog ids with no backlog row yet
```

`--check` is the gate. Run it after every catalog edit, and in CI. A catalog
that does not pass is not a catalog; it is a pile of markdown that will rot
inside a month.
